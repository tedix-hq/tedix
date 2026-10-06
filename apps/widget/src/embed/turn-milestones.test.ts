import { describe, expect, it, vi } from "vite-plus/test";
import { createEmbeddedTurnMilestones } from "./turn-milestones";

describe("embedded turn milestones", () => {
	it.each(["throw", "reject"])(
		"isolates a telemetry sender that can %s",
		async (failure) => {
			const send = vi.fn(() => {
				if (failure === "throw") throw new Error("telemetry unavailable");
				return Promise.reject(new Error("telemetry unavailable"));
			});
			let enabled = false;
			const milestones = createEmbeddedTurnMilestones({
				conversationId: "conversation-test",
				clientRequestId: "request-test",
				enabled: () => enabled,
				send,
			});
			expect(milestones.record("submitted")).toBe(false);
			expect(send).not.toHaveBeenCalled();
			enabled = true;
			expect(milestones.record("submitted")).toBe(true);
			expect(milestones.record("submitted")).toBe(false);
			expect(milestones.record("rendered")).toBe(true);
			expect(send).toHaveBeenCalledTimes(2);
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	);

	it("uses the shared vocabulary, dedupes, and emits content-free batches", () => {
		let enabled = true;
		let elapsed = 100;
		const send = vi.fn();
		const milestones = createEmbeddedTurnMilestones({
			conversationId: "conversation-1",
			clientRequestId: "request-1",
			enabled: () => enabled,
			send,
			now: () => elapsed,
			eventId: () => "11111111-1111-4111-8111-111111111111",
		});

		elapsed = 145;
		expect(milestones.record("submitted")).toBe(true);
		expect(milestones.record("submitted")).toBe(false);
		milestones.record("first_phase", { phase: "using_tool" });
		milestones.record("failed", {
			outcome: "failed",
			errorCode: "stream_unavailable",
		});

		expect(send).toHaveBeenCalledTimes(3);
		expect(send.mock.calls[1]?.[0]).toEqual({
			conversationId: "conversation-1",
			clientRequestId: "request-1",
			events: [
				{
					eventId: "11111111-1111-4111-8111-111111111111",
					milestone: "first_phase",
					durationMs: 45,
					phase: "using_tool",
				},
			],
		});
		expect(JSON.stringify(send.mock.calls)).not.toContain("message");

		enabled = false;
		expect(milestones.record("terminal_received")).toBe(false);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("drops invalid optional codes and bounds reconnect metadata", () => {
		const send = vi.fn();
		const milestones = createEmbeddedTurnMilestones({
			conversationId: "conversation-2",
			clientRequestId: "request-2",
			enabled: () => true,
			send,
			now: () => 0,
			eventId: () => "22222222-2222-4222-8222-222222222222",
		});
		milestones.record("reconnect_started", {
			phase: "contains spaces",
			errorCode: "also invalid",
			reconnectAttempt: 11,
		});
		expect(send.mock.calls[0]?.[0].events[0]).toEqual({
			eventId: "22222222-2222-4222-8222-222222222222",
			milestone: "reconnect_started",
			durationMs: 0,
		});
	});
});
