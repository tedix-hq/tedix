import { isLeanContextSession } from "@tedix/api-contract/utils/runtime-identity";
import { describe, expect, it } from "vite-plus/test";
import { normalizeTediConversationId } from "./events-policy";

describe("reply-draft conversation ids", () => {
	// agent-turn-triage queues drafting turns as `reply-draft:{requestId}`; the
	// runtime must see that session as lean or every draft pays for memory recall.
	it("normalize to a lean runtime session", () => {
		const sessionKey = normalizeTediConversationId(
			"reply-draft:5eed0042-0000-4000-8000-000000000001",
		);
		expect(sessionKey).toBe(
			"agent:main:reply-draft:5eed0042-0000-4000-8000-000000000001",
		);
		expect(isLeanContextSession(sessionKey)).toBe(true);
		// A re-requested attempt (`reply-draft:{requestId}:{n}`) stays lean too.
		expect(
			isLeanContextSession(
				normalizeTediConversationId(
					"reply-draft:5eed0042-0000-4000-8000-000000000001:2",
				),
			),
		).toBe(true);
		expect(isLeanContextSession(normalizeTediConversationId("main"))).toBe(
			false,
		);
	});
});
