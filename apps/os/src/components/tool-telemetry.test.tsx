import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const runtimeApi = vi.hoisted(() => ({ listEvents: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { cognitiveRuntime: runtimeApi },
}));

import { TOOL_EVENTS_LIMIT, type ToolBreakdownRow } from "@/lib/tool-events";
import {
	barPercent,
	BREAKDOWN_TOP_N,
	ratePercent,
	ToolBreakdownRowView,
	ToolEventRow,
	ToolTelemetry,
	ToolTelemetryEmpty,
} from "./tool-telemetry";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEDI_ID = "11111111-1111-4111-8111-111111111111";

const event = (
	id: string,
	kind: "tool.completed" | "tool.failed",
	name: string,
	createdAt: string,
	extra: Record<string, unknown> = {},
): TediRuntimeEvent => ({
	id,
	tediId: TEDI_ID,
	kind,
	createdAt,
	payload: { name, latencyMs: 250, ...extra },
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("ratePercent", () => {
	it("renders a 0..1 rate as a whole percentage", () => {
		expect(ratePercent(0.9333)).toBe("93%");
		expect(ratePercent(1)).toBe("100%");
		expect(ratePercent(0)).toBe("0%");
	});
});

describe("barPercent", () => {
	it("scales against the busiest tool", () => {
		expect(barPercent(5, 10)).toBe(50);
		expect(barPercent(10, 10)).toBe(100);
	});

	// A bar that rounds to zero width says "no calls" about a tool that has one.
	it("keeps a visible floor so one call is never drawn as nothing", () => {
		expect(barPercent(1, 500)).toBe(4);
	});

	it("does not divide by zero on an empty window", () => {
		expect(barPercent(0, 0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

describe("ToolBreakdownRowView", () => {
	const row: ToolBreakdownRow = {
		toolName: "list_orders",
		calls: 12,
		failures: 3,
		successRate: 0.75,
		medianLatencyMs: 240,
	};

	it("names the tool, its calls, its failures, and its median latency", () => {
		const html = renderToStaticMarkup(
			<ToolBreakdownRowView row={row} maxCalls={12} />,
		);
		expect(html).toContain("list_orders");
		expect(html).toContain("12 calls");
		expect(html).toContain("3 failed");
		expect(html).toContain("240ms median");
	});

	it("exposes its selected state so the filter is announced, not just styled", () => {
		const html = renderToStaticMarkup(
			<ToolBreakdownRowView row={row} maxCalls={12} selected />,
		);
		expect(html).toContain('aria-pressed="true"');
	});

	it("omits the failure clause entirely when a tool has never failed", () => {
		const html = renderToStaticMarkup(
			<ToolBreakdownRowView
				row={{ ...row, failures: 0, successRate: 1 }}
				maxCalls={12}
			/>,
		);
		expect(html).not.toContain("failed");
	});
});

describe("ToolEventRow", () => {
	it("shows the error text on a failed call rather than a bare status", () => {
		const html = renderToStaticMarkup(
			<ToolEventRow
				event={{
					id: "e1",
					kind: "tool.failed",
					toolName: "list_accounts",
					success: false,
					latencyMs: 15_020,
					error: "Upstream CRM timed out after 15s",
					createdAt: "2026-08-12T00:00:00.000Z",
					runId: "run-abcdef12",
					conversationId: null,
					toolCallId: null,
				}}
			/>,
		);
		expect(html).toContain("Upstream CRM timed out after 15s");
		expect(html).toContain("Failed");
		expect(html).toContain('data-success="false"');
		expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
		expect(html).toContain("col-span-2 col-start-2");
	});

	it("labels an unnamed tool honestly instead of leaving a blank row", () => {
		const html = renderToStaticMarkup(
			<ToolEventRow
				event={{
					id: "e1",
					kind: "tool.completed",
					toolName: null,
					success: true,
					latencyMs: null,
					error: null,
					createdAt: "2026-08-12T00:00:00.000Z",
					runId: null,
					conversationId: null,
					toolCallId: null,
				}}
			/>,
		);
		expect(html).toContain("(unnamed tool)");
	});
});

describe("ToolTelemetryEmpty", () => {
	it("distinguishes an empty ledger from an empty filter", () => {
		expect(
			renderToStaticMarkup(<ToolTelemetryEmpty filtered={false} />),
		).toContain("No tool calls recorded");
		expect(renderToStaticMarkup(<ToolTelemetryEmpty filtered />)).toContain(
			"No tool calls match this filter",
		);
	});
});

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderSection(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<ToolTelemetry tediId={TEDI_ID} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	runtimeApi.listEvents.mockReset();
	runtimeApi.listEvents.mockImplementation(
		async (input: { kind?: string }) => ({
			events:
				input.kind === "tool.failed"
					? [
							event(
								"f1",
								"tool.failed",
								"list_accounts",
								"2026-08-12T03:00:00.000Z",
								{
									error: "CRM timeout",
								},
							),
						]
					: [
							event(
								"c1",
								"tool.completed",
								"list_orders",
								"2026-08-12T02:00:00.000Z",
							),
							event(
								"c2",
								"tool.completed",
								"list_orders",
								"2026-08-12T01:00:00.000Z",
							),
						],
			nextBefore: null,
		}),
	);
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("ToolTelemetry", () => {
	it("issues one read per settled kind at the endpoint's own cap", async () => {
		renderSection();
		await flush();
		expect(runtimeApi.listEvents).toHaveBeenCalledWith(
			{ tediId: TEDI_ID, kind: "tool.completed", limit: TOOL_EVENTS_LIMIT },
			// The contract-derived option forwards TanStack Query's AbortSignal.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(runtimeApi.listEvents).toHaveBeenCalledWith(
			{ tediId: TEDI_ID, kind: "tool.failed", limit: TOOL_EVENTS_LIMIT },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	// `limit` is capped at 500 by ListRuntimeEventsInputSchema. A read above the
	// cap is a server-side BAD_REQUEST that renders a dead surface.
	it("never requests more than the schema allows", async () => {
		renderSection();
		await flush();
		for (const call of runtimeApi.listEvents.mock.calls) {
			expect((call[0] as { limit: number }).limit).toBeLessThanOrEqual(500);
		}
	});

	// `summary: true` drops the payload bag — which is where name, latency, and
	// error live. Requesting it would silently blank every telemetry column.
	it("never requests the compact summary projection", async () => {
		renderSection();
		await flush();
		for (const call of runtimeApi.listEvents.mock.calls) {
			expect((call[0] as { summary?: boolean }).summary).toBeUndefined();
		}
	});

	it("merges the two kinds into one window and reports its bounds", async () => {
		const container = renderSection();
		await flush();
		expect(
			container.querySelector('[data-slot="page-section"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="section-header"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Recent settled tool calls");
		expect(container.textContent).toContain("3");
		expect(container.textContent).toContain("tool calls");
		expect(container.textContent).toContain("most recent settled tool calls");
		expect(container.textContent).toContain("list_orders");
		expect(container.textContent).toContain("list_accounts");
	});

	it("says the counts are a floor when a per-kind read came back full", async () => {
		runtimeApi.listEvents.mockImplementation(async () => ({
			events: Array.from({ length: TOOL_EVENTS_LIMIT }, (_unused, index) =>
				event(
					`e${index}`,
					"tool.completed",
					"list_orders",
					`2026-08-12T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
				),
			),
			nextBefore: null,
		}));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("these counts are a floor");
	});

	it("distinguishes a refused read from a broken one", async () => {
		runtimeApi.listEvents.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Tool telemetry is not readable with your access",
		);
		expect(container.textContent).not.toContain("No tool calls recorded");
	});

	it("surfaces a genuine failure instead of an empty state", async () => {
		runtimeApi.listEvents.mockRejectedValue(new Error("D1 unavailable"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("Tool telemetry is unavailable");
		expect(container.textContent).toContain("D1 unavailable");
	});

	it("caps the breakdown list at the declared top-N", async () => {
		runtimeApi.listEvents.mockImplementation(
			async (input: { kind?: string }) => ({
				events:
					input.kind === "tool.failed"
						? []
						: Array.from({ length: BREAKDOWN_TOP_N + 4 }, (_unused, index) =>
								event(
									`e${index}`,
									"tool.completed",
									`tool_${index}`,
									`2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`,
								),
							),
				nextBefore: null,
			}),
		);
		const container = renderSection();
		await flush();
		expect(container.querySelectorAll("[data-tool]")).toHaveLength(
			BREAKDOWN_TOP_N,
		);
		expect(container.textContent).toContain("busiest of");
	});
});
