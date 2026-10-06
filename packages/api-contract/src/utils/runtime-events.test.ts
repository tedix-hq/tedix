import { describe, expect, it } from "vite-plus/test";
import {
	bestRuntimeText,
	buildKernelRuntimeEvent,
	buildTediRuntimeEvent,
	buildTediTurnRuntimeEvent,
	homeRuntimeEventId,
	runtimeEventId,
	tediTurnRuntimeEventId,
} from "./runtime-events";

describe("runtime event builders", () => {
	it("builds tedi runtime events with the shared deterministic id scheme", () => {
		const event = buildTediRuntimeEvent({
			tediId: "tedi-1",
			kind: "run.completed",
			conversationId: "conversation-1",
			runId: "run-1",
			sequence: 3,
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-06-13T10:00:00.000Z",
		});

		expect(event).toMatchObject({
			id: runtimeEventId({
				tediId: "tedi-1",
				kind: "run.completed",
				conversationId: "conversation-1",
				runId: "run-1",
				sequence: 3,
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-06-13T10:00:00.000Z",
			}),
			runtime: { backend: "cloudflare-agents" },
			createdAt: "2026-06-13T10:00:00.000Z",
		});
	});

	it("preserves caller-owned ids for body-specific event streams", () => {
		const event = buildTediRuntimeEvent({
			id: "run-1:3",
			tediId: "tedi-1",
			kind: "run.completed",
			conversationId: "conversation-1",
			runId: "run-1",
			sequence: 3,
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-06-13T10:00:00.000Z",
		});

		expect(event.id).toBe("run-1:3");
	});

	it("builds sequenced turn events with the shared run-local id scheme", () => {
		const event = buildTediTurnRuntimeEvent({
			tediId: "tedi-1",
			kind: "message.completed",
			conversationId: "conversation-1",
			runId: "run-1",
			sequence: 2,
			idSuffix: 2,
			payload: { role: "assistant", content: "done" },
			runtimeBackend: "cloudflare-agents",
			traceId: "trace-1",
			createdAt: "2026-06-13T10:00:02.000Z",
		});

		expect(event).toMatchObject({
			id: tediTurnRuntimeEventId("run-1", 2),
			tediId: "tedi-1",
			kind: "message.completed",
			sequence: 2,
			payload: { role: "assistant", content: "done" },
			runtime: {
				backend: "cloudflare-agents",
				metadata: { traceId: "trace-1" },
			},
			createdAt: "2026-06-13T10:00:02.000Z",
		});
	});

	it("builds conversation-created events with a run-scoped id without stamping runId", () => {
		const event = buildTediTurnRuntimeEvent({
			tediId: "tedi-1",
			kind: "conversation.created",
			conversationId: "conversation-1",
			eventIdRunId: "run-1",
			idSuffix: "conv-created",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-06-13T10:00:00.000Z",
		});

		expect(event).toMatchObject({
			id: tediTurnRuntimeEventId("run-1", "conv-created"),
			conversationId: "conversation-1",
			runId: undefined,
		});
	});

	it("builds Home kernel events with the existing Home id fallback order", () => {
		const event = buildKernelRuntimeEvent({
			organizationId: "org-1",
			kind: "subagent.started",
			conversationId: "home:main",
			runId: "home-run-1",
			delegatedTediId: "tedi-child",
			causeEventId: "home-input-event",
			runtimeBackend: "custom",
			runtimeMetadata: { source: "kernelRuntime.test" },
			createdAt: "2026-06-13T10:01:00.000Z",
		});

		expect(event).toMatchObject({
			causeEventId: "home-input-event",
			id: homeRuntimeEventId({
				organizationId: "org-1",
				kind: "subagent.started",
				conversationId: "home:main",
				runId: "home-run-1",
				delegatedTediId: "tedi-child",
				suffix: "2026-06-13T10:01:00.000Z",
			}),
			runtime: {
				backend: "custom",
				externalId: undefined,
				metadata: { source: "kernelRuntime.test" },
			},
		});
	});

	it("prefers the most complete text from nested runtime message payloads", () => {
		expect(
			bestRuntimeText(
				"gateway",
				{
					text: "gateway",
					message: {
						role: "assistant",
						content: "gateway-event-builder-live-1781378888862",
					},
				},
				{
					content: [{ type: "text", text: "short" }],
				},
			),
		).toBe("gateway-event-builder-live-1781378888862");
	});
});
