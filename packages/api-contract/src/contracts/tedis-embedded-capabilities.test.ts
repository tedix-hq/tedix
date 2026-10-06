import { describe, expect, it } from "vite-plus/test";
import { EmbeddedConversationCapabilityTargetSchema } from "./tedis";

describe("embedded conversation capability contract", () => {
	it("accepts only opaque server-derived embedded session keys", () => {
		const tediId = "11111111-1111-4111-8111-111111111111";
		expect(
			EmbeddedConversationCapabilityTargetSchema.parse({
				tediId,
				conversationId: `embed:${"a".repeat(32)}`,
			}),
		).toBeDefined();
		for (const conversationId of [
			"home:browser-choice",
			"embed:user-controlled",
			`embed:${"a".repeat(31)}`,
		]) {
			expect(() =>
				EmbeddedConversationCapabilityTargetSchema.parse({
					tediId,
					conversationId,
				}),
			).toThrow();
		}
	});
});
