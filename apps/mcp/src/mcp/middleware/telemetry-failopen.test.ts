import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ServerContext } from "../server-context";
import { wrapToolCallTelemetry } from "./telemetry";
import { wrapPromptGetTelemetry } from "./prompts-telemetry";

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("../../lib/api-client", () => ({
	getApiClient: () => ({ audit: { createEvent: audit } }),
}));
vi.mock("cloudflare:workers", () => ({
	tracing: {
		enterSpan: (_name: string, callback: (span: unknown) => unknown) =>
			callback({
				setAttribute: () => {
					throw new Error("trace unavailable");
				},
			}),
	},
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("gateway telemetry failure isolation", () => {
	it.each(["throw", "reject", "schedule"])(
		"returns successful tool and prompt results when optional sinks %s",
		async (failure) => {
			audit.mockReset();
			const sink = vi.fn(() => {
				if (failure === "throw")
					throw new Error("Analytics Engine write limit exceeded");
				return Promise.reject(
					new Error("Analytics Engine write limit exceeded"),
				);
			});
			vi.spyOn(console, "log").mockImplementation(() => {
				throw new Error("logs unavailable");
			});
			vi.spyOn(console, "warn").mockImplementation(() => {
				throw new Error("logs unavailable");
			});
			vi.stubGlobal("fetch", sink);
			audit.mockImplementation(sink);
			const pending: Promise<unknown>[] = [];
			const ctx = {
				env: {
					ANALYTICS: { writeDataPoint: sink },
					MCP_PAYLOAD_STREAM_ENDPOINT: "https://sink.example/ingest",
					MCP_PAYLOAD_STREAM_TOKEN: "fixture-token",
				},
				ctx: {
					waitUntil: (p: Promise<unknown>) => {
						if (failure === "schedule") throw new Error("context closed");
						pending.push(p);
					},
				},
				appId: "app-fixture",
				appSlug: "fixture",
				app: { organizationId: "org-fixture" },
				callerIdentity: {
					authType: "oauth",
					userId: "fixture-user",
					scopes: [],
				},
				traceId: "fixture-trace",
			} as unknown as ServerContext;
			const result = { content: [{ type: "text", text: "ok" }] };
			const tool = vi.fn(async () => result);
			const prompt = vi.fn(async () => ({ messages: [] }));
			await expect(
				wrapToolCallTelemetry("fixture", ctx, tool)({}, {} as never),
			).resolves.toBe(result);
			await expect(
				wrapPromptGetTelemetry("fixture", ctx, prompt)({}, {} as never),
			).resolves.toEqual({ messages: [] });
			await Promise.all(pending);
			expect(tool).toHaveBeenCalledTimes(1);
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(sink).toHaveBeenCalled();
			expect(audit).toHaveBeenCalledTimes(2);
		},
	);

	it("preserves the handler error when failure telemetry also fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {
			throw new Error("logs unavailable");
		});
		audit.mockRejectedValue(new Error("audit unavailable"));
		const ctx = {
			env: {},
			ctx: { waitUntil: () => {} },
			appId: "fixture",
			appSlug: "fixture",
			app: {},
			traceId: "fixture",
		} as unknown as ServerContext;
		const failure = new Error("handler failed");
		await expect(
			wrapToolCallTelemetry("fixture", ctx, async () => {
				throw failure;
			})({}, {} as never),
		).rejects.toBe(failure);
	});
});
