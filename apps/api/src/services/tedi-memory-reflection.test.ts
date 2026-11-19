import { describe, expect, it } from "vite-plus/test";
import {
	memoryReflectionEnabled,
	quietConversations,
} from "./tedi-memory-reflection";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (minutesAgo: number) =>
	new Date(NOW - minutesAgo * 60_000).toISOString();
const message = (
	conversationId: string,
	minutesAgo: number,
	kind: "message.received" | "message.completed",
	content: string,
) => ({
	conversationId,
	kind,
	createdAt: at(minutesAgo),
	payload: { content },
});

describe("quietConversations", () => {
	it("picks the tedi's own chat that has been quiet for half an hour, and nothing else", () => {
		const quiet = quietConversations(
			[
				message("lead:agent:main:fresh", 5, "message.received", "Still here"),
				message("lead:telegram:42", 40, "message.received", "Remember this"),
				message("lead:agent:main:chat-7", 40, "message.completed", "Done."),
				message("lead:agent:main:chat-7", 41, "message.received", "Ship it"),
				message("lead:agent:main:old", 200, "message.received", "Long ago"),
			],
			"lead",
			NOW,
		);
		expect(quiet).toEqual([
			{
				conversationId: "lead:agent:main:chat-7",
				lastMessageAt: at(40),
				messages: [
					{ from: "person", text: "Ship it" },
					{ from: "you", text: "Done." },
				],
			},
		]);
	});

	it("is on unless the tedi's stored setting turns it off", () => {
		expect(memoryReflectionEnabled(null)).toBe(true);
		expect(memoryReflectionEnabled({ memoryReflection: false })).toBe(false);
	});
});
