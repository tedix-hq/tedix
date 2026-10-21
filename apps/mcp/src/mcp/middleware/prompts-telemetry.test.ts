import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ServerContext } from "../server-context";
import type { PayloadCaptureRecord } from "../utils/payload-capture";
import {
	type PromptCallback,
	wrapPromptGetTelemetry,
} from "./prompts-telemetry";

const { createEvent } = vi.hoisted(() => ({ createEvent: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
	getApiClient: () => ({ audit: { createEvent } }),
}));

const endpoint = "https://payload.example/ingest";
const sinkToken = "fictional-sink-token";
const extra = {} as Parameters<PromptCallback>[1];

function requestContext(
	id: string,
	capturePayloads: boolean | undefined,
	defaultCapture: string | undefined,
	sink: "configured" | "none" | "endpoint-only" | "token-only" = "configured",
) {
	const pending: Promise<unknown>[] = [];
	const writeDataPoint = vi.fn();
	const identity = {
		appId: `app-${id}`,
		appSlug: `surface-${id}`,
		organizationId: `org-${id}`,
		traceId: `trace-${id}`,
		userId: `user-${id}`,
		tediId: `tedi-${id}`,
		authType: "user" as const,
	};
	const ctx = {
		appId: identity.appId,
		appSlug: identity.appSlug,
		app: { organizationId: identity.organizationId },
		traceId: identity.traceId,
		callerIdentity: {
			userId: identity.userId,
			tediId: identity.tediId,
			authType: identity.authType,
			clientId: `client-${id}`,
			scopes: ["mcp:apps.read"],
		},
		appMetadata: { mcpConfig: { capturePayloads } },
		ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
		env: {
			ANALYTICS: { writeDataPoint },
			MCP_PAYLOAD_CAPTURE_DEFAULT: defaultCapture,
			...(sink === "configured" || sink === "endpoint-only"
				? { MCP_PAYLOAD_STREAM_ENDPOINT: endpoint }
				: {}),
			...(sink === "configured" || sink === "token-only"
				? { MCP_PAYLOAD_STREAM_TOKEN: sinkToken }
				: {}),
		},
	} as unknown as ServerContext;
	return {
		ctx,
		identity,
		writeDataPoint,
		pending,
		drain: () => Promise.all(pending),
	};
}

function payloads(id: string) {
	const args = {
		label: `input-${id}`,
		nested: [{ password: `fictional-password-${id}`, text: "keep input" }],
		note: `use Bearer fictional-input-${id}`,
	};
	const result = {
		messages: [
			{
				role: "user",
				content: { type: "text", text: `reply-${id}` },
				metadata: { api_key: `fictional-key-${id}` },
			},
		],
		nested: { text: `use Bearer fictional-output-${id}` },
	};
	return {
		args,
		result,
		redactedArgs: {
			label: `input-${id}`,
			nested: [{ password: "[REDACTED]", text: "keep input" }],
			note: "use [REDACTED]",
		},
		redactedResult: {
			messages: [
				{
					role: "user",
					content: { type: "text", text: `reply-${id}` },
					metadata: { api_key: "[REDACTED]" },
				},
			],
			nested: { text: "use [REDACTED]" },
		},
	};
}

let records: PayloadCaptureRecord[];
let sinkFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
	createEvent.mockReset().mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
	records = [];
	sinkFetch = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe(endpoint);
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				Authorization: `Bearer ${sinkToken}`,
				"Content-Type": "application/json",
			},
		});
		const batch = JSON.parse(String(init?.body)) as PayloadCaptureRecord[];
		expect(batch).toHaveLength(1);
		records.push(...batch);
		return new Response(null, { status: 204 });
	});
	vi.stubGlobal("fetch", sinkFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function expectCapture(
	record: PayloadCaptureRecord | undefined,
	request: ReturnType<typeof requestContext>,
	data: ReturnType<typeof payloads>,
	fails: boolean,
) {
	expect(record).toMatchObject({
		...request.identity,
		toolName: "compose_reply",
		eventType: "prompt_get",
		success: fails ? 0 : 1,
		errorCode: fails ? "UNHANDLED_ERROR" : "",
		inputArgs: JSON.stringify(data.redactedArgs),
		outputBody: fails ? "" : JSON.stringify(data.redactedResult),
		outputBytes: fails ? 0 : expect.any(Number),
		truncated: 0,
	});
}

describe.each([false, true])("prompt payload capture (throws=%s)", (fails) => {
	it.each([
		{ capture: false, fallback: "on", allowed: false },
		{ capture: false, fallback: "off", allowed: false },
		{ capture: true, fallback: "off", allowed: true },
		{ capture: true, fallback: "on", allowed: true },
		{ capture: undefined, fallback: "off", allowed: false },
		{ capture: undefined, fallback: "on", allowed: true },
		{ capture: undefined, fallback: undefined, allowed: true },
	])(
		"honors app=$capture and default=$fallback",
		async ({ capture, fallback, allowed }) => {
			const request = requestContext("policy", capture, fallback);
			const data = payloads("policy");
			const original = structuredClone(data);
			const error = new Error("fictional prompt failure");
			const callback = vi.fn((args, context) => {
				expect(args).toBe(data.args);
				expect(context).toBe(extra);
				expect(args).toEqual(original.args);
				if (fails) throw error;
				return data.result;
			});
			const wrapped = wrapPromptGetTelemetry(
				"compose_reply",
				request.ctx,
				callback,
			);
			const outcome = wrapped(data.args, extra);
			if (fails) await expect(outcome).rejects.toBe(error);
			else await expect(outcome).resolves.toBe(data.result);
			await request.drain();

			expect(data).toEqual(original);
			expect(sinkFetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(records).toHaveLength(allowed ? 1 : 0);
			if (allowed) expectCapture(records[0], request, data, fails);
			expect(request.writeDataPoint).toHaveBeenCalled();
			expect(createEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: request.identity.organizationId,
					actorId: request.identity.userId,
					action: fails ? "mcp.prompt.error" : "mcp.prompt.execute",
					metadata: expect.objectContaining({
						traceId: request.identity.traceId,
					}),
				}),
			);
			expect(request.pending).toHaveLength(allowed ? 2 : 1);
		},
	);

	it.each(["none", "endpoint-only", "token-only"] as const)(
		"skips capture with %s sink configuration while retaining telemetry",
		async (sink) => {
			const request = requestContext("missing", true, "on", sink);
			const data = payloads("missing");
			const original = structuredClone(data);
			const error = new Error("fictional prompt failure");
			const wrapped = wrapPromptGetTelemetry(
				"compose_reply",
				request.ctx,
				() => {
					if (fails) throw error;
					return data.result;
				},
			);
			const outcome = wrapped(data.args, extra);
			if (fails) await expect(outcome).rejects.toBe(error);
			else await expect(outcome).resolves.toBe(data.result);
			await request.drain();
			expect(data).toEqual(original);
			expect(sinkFetch).not.toHaveBeenCalled();
			expect(request.writeDataPoint).toHaveBeenCalled();
			expect(createEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: request.identity.organizationId,
					action: fails ? "mcp.prompt.error" : "mcp.prompt.execute",
				}),
			);
		},
	);
});

it.each([false, true])(
	"keeps overlapping requests isolated when the second throws=%s",
	async (secondFails) => {
		const first = requestContext("first", true, "off");
		const second = requestContext("second", undefined, "on");
		const firstData = payloads("first");
		const secondData = payloads("second");
		const original = structuredClone([firstData, secondData]);
		const firstGate = Promise.withResolvers<typeof firstData.result>();
		const secondGate = Promise.withResolvers<typeof secondData.result>();
		const firstExtra = {} as Parameters<PromptCallback>[1];
		const secondExtra = {} as Parameters<PromptCallback>[1];
		const firstCallback = vi.fn<PromptCallback>((args, context) => {
			expect(args).toBe(firstData.args);
			expect(context).toBe(firstExtra);
			return firstGate.promise;
		});
		const secondCallback = vi.fn<PromptCallback>((args, context) => {
			expect(args).toBe(secondData.args);
			expect(context).toBe(secondExtra);
			return secondGate.promise;
		});
		const firstOutcome = wrapPromptGetTelemetry(
			"compose_reply",
			first.ctx,
			firstCallback,
		)(firstData.args, firstExtra);
		const secondOutcome = wrapPromptGetTelemetry(
			"compose_reply",
			second.ctx,
			secondCallback,
		)(secondData.args, secondExtra);
		expect(firstCallback).toHaveBeenCalledWith(firstData.args, firstExtra);
		expect(secondCallback).toHaveBeenCalledWith(secondData.args, secondExtra);
		expect(records).toEqual([]);

		const error = new Error("fictional second request failure");
		const secondCheck = secondFails
			? expect(secondOutcome).rejects.toBe(error)
			: expect(secondOutcome).resolves.toBe(secondData.result);
		if (secondFails) secondGate.reject(error);
		else secondGate.resolve(secondData.result);
		await secondCheck;
		await second.drain();
		expect(first.pending).toEqual([]);
		expect(first.writeDataPoint).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expectCapture(records[0], second, secondData, secondFails);

		firstGate.resolve(firstData.result);
		await expect(firstOutcome).resolves.toBe(firstData.result);
		await first.drain();
		expect(records).toHaveLength(2);
		expectCapture(records[1], first, firstData, false);
		expect([firstData, secondData]).toEqual(original);
		for (const request of [first, second]) {
			expect(request.writeDataPoint).toHaveBeenCalled();
			expect(createEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: request.identity.organizationId,
					actorId: request.identity.userId,
					metadata: expect.objectContaining({
						traceId: request.identity.traceId,
					}),
				}),
			);
		}
	},
);
