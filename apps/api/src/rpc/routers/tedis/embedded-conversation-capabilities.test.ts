import { describe, expect, it } from "vite-plus/test";
import { assertEmbeddedRuntimeIdentity } from "./embedded-conversation-capabilities";

describe("embedded conversation capability authority", () => {
	it("accepts only the matching service-bound tedi runtime", () => {
		expect(() =>
			assertEmbeddedRuntimeIdentity(
				{ authType: "service-binding", tediId: "tedi-a" },
				"tedi-a",
			),
		).not.toThrow();
		for (const context of [
			{ authType: "user", tediId: "tedi-a" },
			{ authType: "service-binding", tediId: "tedi-b" },
			{ authType: "service-binding" },
		]) {
			expect(() => assertEmbeddedRuntimeIdentity(context, "tedi-a")).toThrow(
				"matching tedi runtime",
			);
		}
	});
});
