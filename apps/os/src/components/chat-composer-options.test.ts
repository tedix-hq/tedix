import { describe, expect, it } from "vite-plus/test";
import { chatComposerPlaceholder } from "@/components/chat-composer-options";

describe("chatComposerPlaceholder", () => {
	it("invites a question or hand-off on a new conversation", () => {
		expect(chatComposerPlaceholder(false)).toBe(
			"Ask a question or hand off a task…",
		);
	});

	it("invites a follow-up once the thread has messages", () => {
		expect(chatComposerPlaceholder(true)).toBe("Ask a follow-up…");
	});
});
