import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
} from "@tedix/webmcp-core/registry";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import {
	MAX_TELEMETRY_BATCH_EVENTS,
	TELEMETRY_FLUSH_INTERVAL_MS,
	type WebMcpTelemetryBatchV1,
} from "./telemetry";
import {
	createWebMcpTelemetryBatcher,
	installWebMcpTelemetry,
	resetWebMcpTelemetryForTests,
} from "./telemetry-client";

const INVOCATION_ID = "00000000-0000-4000-8000-000000000001";

function event(tool: string) {
	return {
		tool,
		scope: "work",
		outcome: "ok" as const,
		durationMs: 12,
		invocationId: INVOCATION_ID,
	};
}

function harness() {
	const sent: WebMcpTelemetryBatchV1[] = [];
	const batcher = createWebMcpTelemetryBatcher((body) => {
		sent.push(JSON.parse(body) as WebMcpTelemetryBatchV1);
	});
	return { sent, batcher };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	resetWebMcpTelemetryForTests();
	vi.useRealTimers();
});

describe("createWebMcpTelemetryBatcher", () => {
	it("buffers below the cap and flushes on the interval timer", () => {
		const { sent, batcher } = harness();
		batcher.record(event("list_work_items"));
		batcher.record(event("get_work_item"));
		expect(sent).toHaveLength(0);

		vi.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS - 1);
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(1);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			schemaVersion: 1,
			events: [
				{
					tool: "list_work_items",
					scope: "work",
					outcome: "ok",
					durationMs: 12,
					invocationId: INVOCATION_ID,
				},
				{
					tool: "get_work_item",
					scope: "work",
					outcome: "ok",
					durationMs: 12,
					invocationId: INVOCATION_ID,
				},
			],
		});
	});

	it("flushes immediately when the buffer reaches the batch cap", () => {
		const { sent, batcher } = harness();
		for (let i = 0; i < MAX_TELEMETRY_BATCH_EVENTS; i += 1) {
			batcher.record(event(`tool_${i}`));
		}
		expect(sent).toHaveLength(1);
		expect(sent[0]?.events).toHaveLength(MAX_TELEMETRY_BATCH_EVENTS);

		// The buffer and timer are cleared; the interval sends nothing more.
		vi.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
		expect(sent).toHaveLength(1);
	});

	it("flush drains once and is a no-op when empty", () => {
		const { sent, batcher } = harness();
		batcher.flush();
		expect(sent).toHaveLength(0);
		batcher.record(event("list_work_items"));
		batcher.flush();
		batcher.flush();
		expect(sent).toHaveLength(1);
	});

	it("ships only the allowlisted fields, dropping anything extra", () => {
		const { sent, batcher } = harness();
		batcher.record({
			...event("list_work_items"),
			invocationId: "5b2f0f9c-7f68-4a3a-9a58-0b6a9a1c2d3e",
			// A future observer field must not silently widen the wire shape.
			args: { secret: "customer content" },
		} as never);
		batcher.flush();
		expect(Object.keys(sent[0]!.events[0]!).sort()).toEqual([
			"durationMs",
			"invocationId",
			"outcome",
			"scope",
			"tool",
		]);
		expect(sent[0]!.events[0]!.invocationId).toBe(
			"5b2f0f9c-7f68-4a3a-9a58-0b6a9a1c2d3e",
		);
	});

	it("survives a throwing transport without losing later batches", () => {
		let calls = 0;
		const batcher = createWebMcpTelemetryBatcher(() => {
			calls += 1;
			throw new Error("beacon refused");
		});
		batcher.record(event("list_work_items"));
		expect(() => batcher.flush()).not.toThrow();
		batcher.record(event("get_work_item"));
		batcher.flush();
		expect(calls).toBe(2);
	});
});

describe("installWebMcpTelemetry", () => {
	afterEach(() => {
		setModelContextResolverForTests(null);
	});

	it("installs the observer once and flushes buffered events on pagehide", async () => {
		const sent: WebMcpTelemetryBatchV1[] = [];
		installWebMcpTelemetry((body) => {
			sent.push(JSON.parse(body) as WebMcpTelemetryBatchV1);
		});
		// Second install is a no-op; the first batcher stays wired.
		installWebMcpTelemetry(() => {
			throw new Error("second install must not win");
		});

		// Drive one real invocation through the dependency-free registry so
		// the installed observer records it, exactly as production does.
		const projected: WebMcpToolDef[][] = [];
		setModelContextResolverForTests(() => ({
			provideContext: ({ tools }) => projected.push(tools),
		}));
		registerWebMcpScope("work", [
			{
				name: "list_work_items",
				description: "d",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: true, untrustedContentHint: false },
				execute: async () => ({ content: [{ type: "text", text: "{}" }] }),
			},
		]);
		await projected.at(-1)?.[0]?.execute({});
		expect(sent).toHaveLength(0);

		window.dispatchEvent(new Event("pagehide"));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.events).toEqual([
			expect.objectContaining({
				tool: "list_work_items",
				scope: "work",
				outcome: "ok",
				invocationId: expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
				),
			}),
		]);
	});
});
