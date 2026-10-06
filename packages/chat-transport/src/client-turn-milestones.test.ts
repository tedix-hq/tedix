import { describe, expect, it } from "vite-plus/test";
import { validateClientTurnMilestoneBatch } from "./client-turn-milestones";

const valid = () => ({
	conversationId: "conversation_123",
	clientRequestId: "request_123",
	events: [
		{
			eventId: "11111111-1111-4111-8111-111111111111",
			milestone: "first_text" as const,
			durationMs: 42,
		},
	],
});

describe("client turn milestones", () => {
	it("accepts a bounded content-free event", () => {
		expect(validateClientTurnMilestoneBatch(valid())).toEqual(valid());
	});

	it.each([
		"prompt",
		"output",
		"reasoning",
		"pageContext",
		"url",
		"origin",
		"hostUserId",
	])("rejects the content or identity field %s", (field) => {
		const input = valid() as Record<string, unknown>;
		input.events = [{ ...valid().events[0], [field]: "secret" }];
		expect(() => validateClientTurnMilestoneBatch(input)).toThrow(
			"Invalid client milestone event",
		);
	});

	it("rejects duplicate ids and excessive durations", () => {
		const input = valid();
		input.events.push({
			eventId: "22222222-2222-4222-8222-222222222222",
			milestone: "first_text",
			durationMs: 300_001,
		});
		expect(() => validateClientTurnMilestoneBatch(input)).toThrow();
	});
});
